/**
 * 「選物」的〈主理人的選品〉分頁。
 *
 * 內容逐字搬自舊的 src/routes/curated.tsx（2026-09-02 導覽列合併）。
 *
 * 2026-10-26 起選品可以連到真正的商品（curated_items.product_id，0041；後台在選品編輯頁
 * 的「連結商品」設定）：
 *
 *   沒連結                         → 照舊只展示（名稱＋備註），結尾的「詢問與選購」
 *   連到 catalogue 裡的書籍／選物   → 卡片多一段價格、加入購物車、查看商品
 *   連到但 catalogue 對不到         → 也只展示。catalogue 只有 active 的商品，下架、
 *                                    讀失敗、或（不該發生的）票券都落在這裡——與
 *                                    PublicationsPanel「product_id 有值但商品讀不到」同一條線
 *
 * ⚠️ 仍然是自己的分頁，不跟〈商品〉混在同一個格狀清單：大部分選品還是買不到，混在一起
 *    客人會以為那些都能加入購物車。
 *
 * 🔴 加入購物車只呼叫既有的 useCart().addItem(cartInputFor(product, 1))——與首頁那一排、
 *    地方刊物分頁同一行，數量上限與售完判斷都在那裡，這裡不另外算。
 */
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";
import { PriceTag } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { pageText, type CuratedThemeEntry, type PageContent } from "@/lib/cms";
import { CARD } from "@/lib/feature-layout";
import { cartInputFor, useCart } from "@/lib/cart";
import { isShelfProductType } from "@/lib/home-shelf";
import { isSoldOut, type ShopListCardResult, type ShopProductCard } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import { PanelIntro } from "./PublicationsPanel";

/** 後備文案 —— 只有在 Supabase 讀不到 pages/'curated' 那一列時才會用到。 */
const COPY = {
  title: { zh: "主理人的選品", en: "The Owner's Curated Window", ja: "店主の選品" },
  themeEmpty: {
    zh: "這個櫥窗正在整理中，很快會放上選件。",
    en: "This window is being arranged — pieces will appear here shortly.",
    ja: "こちらのウィンドウは準備中です。まもなく選品が並びます。",
  },
  intro: {
    zh: "我們以「主題櫥窗」呈現選物，而非商品清單。每一件物，都是一段被留下來的時間。",
    en: "We arrange the selection as themed windows, not as a catalogue. Each piece holds a quiet stretch of time.",
    ja: "商品リストではなく、テーマの窓辺として並べています。一品一品が、留まった時間そのもの。",
  },
  windowLabel: { zh: "Window", en: "Window", ja: "Window" },
  askPurchase: { zh: "詢問與選購", en: "Ask & purchase", ja: "お問合せ・お求め" },
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
} satisfies Record<string, Localized>;

export function CuratedPanel({
  page,
  curatedThemes,
  catalogue,
}: {
  page: PageContent | null;
  curatedThemes: CuratedThemeEntry[];
  /** /shop 的 loader 已經讀好的那一份（與〈商品〉〈地方刊物〉共用），不另外查。 */
  catalogue: ShopListCardResult;
}) {
  const t = useT();
  const p = pageText(page);
  const { ui, contactEmail, social } = useSiteContent();
  const addItem = useCart((s) => s.addItem);
  const productById = useMemo(
    () => new Map(catalogue.products.map((prod) => [prod.id, prod])),
    [catalogue.products],
  );

  /** 只有書籍／選物算「買得到」：票券要先選場次，不能從這裡加購物車。 */
  const linkedProduct = (productId: string | null | undefined): ShopProductCard | null => {
    if (!productId) return null;
    const prod = productById.get(productId);
    return prod && isShelfProductType(prod.productType) ? prod : null;
  };

  const add = (product: ShopProductCard) => {
    const result = addItem(cartInputFor(product, 1));
    if (result === "added") toast.success(t(p.block("addedToast", COPY.addedToast)));
    else if (result === "capped") toast.warning(t(p.block("cappedToast", COPY.cappedToast)));
    else toast.error(t(p.block("soldOutToast", COPY.soldOutToast)));
  };

  return (
    <>
      <PanelIntro title={t(p.title(COPY.title))} intro={t(p.intro(COPY.intro))} />

      <section className="container-editorial pb-24 space-y-32" data-testid="curated-themes">
        {curatedThemes.map((theme, i) => (
          <div key={theme.id}>
            <div className="grid md:grid-cols-12 gap-10 items-end mb-12">
              <div className="md:col-span-5">
                <p className="eyebrow text-2xl">
                  {t(p.block("windowLabel", COPY.windowLabel))} {String(i + 1).padStart(2, "0")}
                </p>
                <h3 className="display mt-4 text-4xl md:text-5xl">{t(theme.title)}</h3>
              </div>
              <p className="md:col-span-7 text-base leading-relaxed text-muted-foreground md:pb-2">
                {t(theme.description)}
              </p>
            </div>

            {/* 一個還沒放品項的主題，底下會是一個空的格線——主題標題下面什麼都沒有。
                後台是先建主題、再加品項，所以這個中間狀態是真的會被看到的。 */}
            {theme.items.length === 0 ? (
              <p className="border border-border p-7 text-sm leading-relaxed text-muted-foreground md:p-8">
                {t(p.block("themeEmpty", COPY.themeEmpty))}
              </p>
            ) : (
              // 一件一張獨立卡片，外框用前台共用的 CARD（src/lib/feature-layout.ts）；
              // 卡片本身不是連結，所以不加 CARD_HOVER（可以點的是裡面的購買鈕與商品連結）。
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:gap-8 lg:grid-cols-3">
                {theme.items.map((item, idx) => {
                  const product = linkedProduct(item.productId);
                  const soldOut = product !== null && isSoldOut(product);
                  return (
                    <article
                      key={idx}
                      className={`${CARD} p-5 md:p-6`}
                      data-testid="curated-item"
                      data-purchasable={product !== null && !soldOut ? "yes" : "no"}
                    >
                      <p className="text-[0.65rem] tracking-widest text-muted-foreground">
                        {String(idx + 1).padStart(2, "0")}
                      </p>
                      <h4 className="font-serif text-xl mt-3 leading-snug">{t(item.name)}</h4>
                      <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                        {t(item.note)}
                      </p>
                      {product && (
                        <div className="mt-auto pt-6">
                          <PriceTag price={product.price} compareAtPrice={product.compareAtPrice} />
                          <div className="mt-4 flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              onClick={() => add(product)}
                              disabled={soldOut}
                              data-testid="add-to-cart"
                              className="border border-foreground bg-foreground px-5 py-2.5 text-xs tracking-widest text-primary-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100"
                            >
                              {soldOut ? t(ui.buttons.soldOut) : t(ui.buttons.addToCart)}
                              <span className="sr-only">（{t(item.name)}）</span>
                            </button>
                            <Link
                              to="/shop/$slug"
                              params={{ slug: product.slug }}
                              className="text-xs tracking-widest text-muted-foreground hover-underline hover:text-foreground"
                            >
                              {t(ui.buttons.viewProduct)}
                            </Link>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 flex flex-wrap gap-4 text-xs tracking-widest items-center">
          <span className="text-muted-foreground mr-4">
            {t(p.block("askPurchase", COPY.askPurchase))}
          </span>
          <a
            className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
            href={`mailto:${contactEmail}`}
          >
            {t(ui.buttons.emailUs)}
          </a>
          <a
            className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
            href={social.line}
            target="_blank"
            rel="noreferrer"
          >
            {t(ui.buttons.line)}
          </a>
          <span className="text-clay">{t(ui.buttons.inStore)}</span>
        </div>
      </section>
    </>
  );
}
