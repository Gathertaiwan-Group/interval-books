import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { PRODUCT_TYPE_LABELS } from "@/components/shop/labels";
import { PriceTag, QuantityStepper, StockBadge } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { keyOfLine, useCart, useCartHydrated, useCartSubtotal, type CartLine } from "@/lib/cart";
import { imageFor } from "@/lib/images";
import { fetchActiveProducts, formatPrice } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import curatedImg from "@/assets/curated-objects.jpg";

const PAGE = {
  metaTitle: {
    zh: "購物車 Cart｜小時光書店 Interval Books",
    en: "Cart｜Interval Books",
    ja: "カート｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "查看你在小時光書店挑選的書籍與選物，調整數量或移除品項。",
    en: "Review the books and objects you have picked at Interval Books, and adjust or remove them.",
    ja: "小時光書店で選んだ書籍やセレクト品を確認し、数量の変更や削除ができます。",
  },
  eyebrowSuffix: { zh: "購物車", en: "Cart", ja: "カート" },
  title: { zh: "你挑好的", en: "What you have chosen", ja: "お選びのもの" },
  intro: {
    zh: "數量與品項都可以再調整。購物車會留在這台裝置上，離開頁面也不會消失。",
    en: "Adjust quantities or remove anything you have changed your mind about. Your cart stays on this device, even if you close the page.",
    ja: "数量の変更も削除も自由です。カートの内容はこの端末に保存され、ページを閉じても残ります。",
  },
  empty: {
    zh: "購物車還是空的。",
    en: "Your cart is empty for now.",
    ja: "カートはまだ空です。",
  },
  quantity: { zh: "數量", en: "Quantity", ja: "数量" },
  subtotal: { zh: "小計", en: "Subtotal", ja: "小計" },
  subtotalNote: {
    zh: "小計不含運費。",
    en: "Subtotal does not include shipping.",
    ja: "小計に送料は含まれません。",
  },
  checkoutNote: {
    zh: "運費會在下一步依寄送方式計算。付款方式可選信用卡線上付款或銀行匯款。",
    en: "Shipping is worked out at the next step, once you pick a delivery method. You can pay by card online or by bank transfer.",
    ja: "送料は次のステップでお届け方法に応じて計算されます。お支払いはクレジットカード決済または銀行振込をご利用いただけます。",
  },
  checkout: { zh: "前往結帳", en: "Checkout", ja: "ご購入手続きへ" },
  checkoutBlocked: {
    zh: "請先移除無法購買的品項",
    en: "Remove the unavailable items first",
    ja: "ご購入いただけない商品を削除してください",
  },
  delisted: {
    zh: "此商品已下架",
    en: "No longer available",
    ja: "現在お取り扱いがありません",
  },
  soldOutLine: { zh: "此商品已售完", en: "Sold out", ja: "完売しました" },
  cappedToast: {
    zh: "已達可購買數量上限",
    en: "That is all we have available",
    ja: "ご購入いただける上限に達しました",
  },
  atLimit: { zh: "已達上限", en: "At the limit", ja: "上限です" },
  removed: { zh: "已移除", en: "Removed", ja: "削除しました" },
};

/**
 * Stable empty array for the pre-hydration render. A fresh `[]` literal here
 * would be a new reference every render and defeat React's bail-out.
 */
const NO_ITEMS: CartLine[] = [];

export const Route = createFileRoute("/cart")({
  // The catalogue is read so the cart can reconcile its localStorage snapshot
  // against live prices and stock — see syncFromCatalogue in src/lib/cart.ts.
  loader: async () => ({ catalogue: await fetchActiveProducts() }),
  head: () => ({
    meta: [
      { title: PAGE.metaTitle.zh },
      { name: "description", content: PAGE.metaDescription.zh },
      { property: "og:title", content: PAGE.title.zh },
      { property: "og:description", content: PAGE.metaDescription.zh },
      // The cart is a private, per-device page — deliberately kept out of
      // search results rather than merely uninteresting to them.
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Cart,
});

function Cart() {
  const t = useT();
  const { catalogue } = Route.useLoaderData();
  const { ui } = useSiteContent();

  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.title,
  });

  const hydrated = useCartHydrated();
  const storedItems = useCart((s) => s.items);
  const setQty = useCart((s) => s.setQty);
  const removeItem = useCart((s) => s.removeItem);
  const syncFromCatalogue = useCart((s) => s.syncFromCatalogue);
  const storedSubtotal = useCartSubtotal();

  // Until localStorage has been read, render exactly what the server rendered.
  const items = hydrated ? storedItems : NO_ITEMS;
  const subtotal = hydrated ? storedSubtotal : 0;
  const canCheckout = items.length > 0 && items.every((i) => !i.unavailable);

  useEffect(() => {
    // Never reconcile against a failed read: every line would look de-listed.
    if (!hydrated || catalogue.unavailable) return;
    syncFromCatalogue(catalogue.products);
  }, [hydrated, catalogue, syncFromCatalogue]);

  // ⚠️ keyOfLine(), not line.productId. Since migration 0020 a product can be in
  // the cart twice — once per sitting — and keying these on the product id would
  // change the quantity of whichever line happened to come first.
  function handleQty(line: CartLine, next: number) {
    const result = setQty(keyOfLine(line), next);
    if (result === "capped") toast.warning(t(PAGE.cappedToast));
  }

  function handleRemove(line: CartLine) {
    removeItem(keyOfLine(line));
    toast.success(t(PAGE.removed));
  }

  return (
    <PageShell>
      <PageHeader
        eyebrow={`Cart  ／  ${t(PAGE.eyebrowSuffix)}`}
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      {items.length === 0 ? (
        <section className="container-editorial pb-32">
          <div className="border border-border p-10">
            <p className="text-sm text-muted-foreground">{t(PAGE.empty)}</p>
            <Link
              to="/shop"
              className="mt-8 inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
            >
              {t(ui.buttons.continueShopping)}
            </Link>
          </div>
        </section>
      ) : (
        <section className="container-editorial pb-32 grid gap-12 lg:grid-cols-3 lg:gap-16">
          <ul className="lg:col-span-2 border-t border-border">
            {items.map((line) => {
              const gone = line.unavailable !== undefined;
              const atLimit = line.limit !== null && line.qty >= line.limit;
              return (
                <li
                  key={keyOfLine(line)}
                  className="flex gap-5 border-b border-border py-7 md:gap-7"
                >
                  <Link
                    to="/shop/$slug"
                    params={{ slug: line.slug }}
                    className="h-24 w-24 shrink-0 overflow-hidden bg-muted md:h-28 md:w-28"
                  >
                    <img
                      src={imageFor(line.imageKey, curatedImg)}
                      alt={t(line.title)}
                      className={`h-full w-full object-cover ${gone ? "opacity-40" : ""}`}
                      loading="lazy"
                    />
                  </Link>

                  <div className="flex min-w-0 flex-1 flex-col">
                    <p className="eyebrow text-xl">{t(PRODUCT_TYPE_LABELS[line.productType])}</p>
                    <Link
                      to="/shop/$slug"
                      params={{ slug: line.slug }}
                      className="mt-1 font-serif text-lg leading-snug hover:underline underline-offset-4"
                    >
                      {t(line.title)}
                    </Link>
                    {/* 場次名稱：同一件商品可能在購物車裡出現兩次（兩個梯次），
                        沒有這一行就分不出哪一列是哪一場。 */}
                    {line.sessionTitle ? (
                      <p className="mt-1 text-xs text-muted-foreground">{t(line.sessionTitle)}</p>
                    ) : null}
                    {/* 方案名稱（0036）：同一場次可能有兩種方案各佔一行，沒有這一行
                        分不出哪一列是「單人票」哪一列是「雙人房」。 */}
                    {line.planTitle ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{t(line.planTitle)}</p>
                    ) : null}

                    {gone ? (
                      <div className="mt-3">
                        <StockBadge tone="alert">
                          {line.unavailable === "delisted" ? t(PAGE.delisted) : t(PAGE.soldOutLine)}
                        </StockBadge>
                      </div>
                    ) : (
                      <>
                        <PriceTag
                          price={line.price}
                          compareAtPrice={line.compareAtPrice}
                          className="mt-3"
                        />
                        <div className="mt-4 flex flex-wrap items-center gap-4">
                          <QuantityStepper
                            value={line.qty}
                            max={line.limit}
                            onChange={(next) => handleQty(line, next)}
                            label={t(PAGE.quantity)}
                          />
                          {atLimit && (
                            <span className="text-[0.7rem] tracking-widest text-clay">
                              {t(PAGE.atLimit)}
                            </span>
                          )}
                        </div>
                      </>
                    )}

                    <div className="mt-4 flex items-center justify-between gap-4">
                      <button
                        type="button"
                        onClick={() => handleRemove(line)}
                        className="inline-flex items-center gap-2 text-[0.7rem] tracking-widest text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        {t(ui.buttons.remove)}
                      </button>
                      {!gone && (
                        <span className="font-serif text-base tabular-nums">
                          {formatPrice(line.price * line.qty)}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <aside className="lg:col-span-1">
            <div className="border border-border p-7 md:p-8 lg:sticky lg:top-28">
              <div className="flex items-baseline justify-between gap-4">
                <span className="eyebrow text-xl">{t(PAGE.subtotal)}</span>
                <span className="font-serif text-2xl tabular-nums">{formatPrice(subtotal)}</span>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {t(PAGE.subtotalNote)}
              </p>

              <div className="rule my-7" />

              {/* An unavailable line cannot be ordered, and the checkout would
                  only reject the whole cart on arrival — so the way forward is
                  blocked here, where the remove button is, rather than one page
                  later where it is not. */}
              {canCheckout ? (
                <Link
                  to="/checkout"
                  className="block w-full border border-foreground bg-foreground px-5 py-4 text-center text-xs tracking-widest text-primary-foreground transition-opacity hover:opacity-85"
                >
                  {t(PAGE.checkout)}
                </Link>
              ) : (
                <p className="border border-clay px-5 py-4 text-center text-xs tracking-widest text-clay">
                  {t(PAGE.checkoutBlocked)}
                </p>
              )}

              <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
                {t(PAGE.checkoutNote)}
              </p>

              <Link
                to="/shop"
                className="mt-7 inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
              >
                {t(ui.buttons.continueShopping)}
              </Link>
            </div>
          </aside>
        </section>
      )}
    </PageShell>
  );
}
