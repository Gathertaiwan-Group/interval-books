/**
 * Small pieces shared by the three storefront routes (/shop, /shop/$slug,
 * /cart). They live here rather than in any one route because a price rendered
 * three different ways is how a strikethrough ends up on the wrong number.
 *
 * None of this touches the database; everything arrives as props. Shared
 * non-component copy lives in ./labels.ts so this file exports components only
 * and Fast Refresh keeps working.
 */
import { Minus, Plus } from "lucide-react";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { formatPrice } from "@/lib/shop";

/**
 * Price, with the "was" price struck through when the product carries one.
 *
 * compare_at_price is only shown when it is genuinely higher than the current
 * price — a struck-through number that is equal to or below what you are being
 * charged is at best noise and at worst a false discount claim.
 */
export function PriceTag({
  price,
  compareAtPrice,
  className = "",
  size = "base",
}: {
  price: number;
  compareAtPrice: number | null;
  className?: string;
  size?: "base" | "lg";
}) {
  const t = useT();
  const showCompare = compareAtPrice !== null && compareAtPrice > price;
  return (
    <p className={`flex flex-wrap items-baseline gap-3 ${className}`}>
      <span className={size === "lg" ? "font-serif text-3xl" : "font-serif text-lg"}>
        {formatPrice(price)}
      </span>
      {showCompare && (
        <span className="text-sm text-muted-foreground line-through">
          {formatPrice(compareAtPrice)}
          <span className="sr-only"> {t(WAS_PRICE_LABEL)}</span>
        </span>
      )}
    </p>
  );
}

/** Screen-reader-only clarification of what the struck-through number means. */
const WAS_PRICE_LABEL: Localized = { zh: "原價", en: "original price", ja: "元の価格" };

/**
 * −/+ quantity control.
 *
 * Unlike the Realreal original, `+` is disabled once `value` reaches `max`
 * rather than letting the shopper click freely and only discovering the cap
 * from a toast after pressing "add to cart". `max === null` means unlimited.
 */
export function QuantityStepper({
  value,
  max,
  onChange,
  label,
  disabled = false,
}: {
  value: number;
  max: number | null;
  onChange: (next: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const atMax = max !== null && value >= max;
  return (
    <div className="inline-flex items-center border border-border" role="group" aria-label={label}>
      <button
        type="button"
        onClick={() => onChange(value - 1)}
        disabled={disabled || value <= 1}
        aria-label={`${label} −`}
        className="flex h-10 w-10 items-center justify-center text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Minus className="h-4 w-4" aria-hidden="true" />
      </button>
      <span className="min-w-10 text-center text-sm tabular-nums" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        disabled={disabled || atMax}
        aria-label={`${label} +`}
        className="flex h-10 w-10 items-center justify-center text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Small outlined badge, used for "sold out" / "only N left". */
export function StockBadge({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "alert";
}) {
  return (
    <span
      className={`inline-block border px-3 py-1 text-xs tracking-widest ${
        tone === "alert" ? "border-clay text-clay" : "border-border text-muted-foreground"
      }`}
    >
      {children}
    </span>
  );
}
