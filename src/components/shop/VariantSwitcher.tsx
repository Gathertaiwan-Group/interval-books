/**
 * 商品頁「規格切換」：同一組（進銷存 series 相同）的已上架商品，依 issue_number 的
 * 規格值畫成幾排選擇鈕（例如「罐別」「口味」）。資料格式與規則見
 * src/lib/product-variants.ts。
 *
 * 每一顆鈕都是**連到那件商品頁的連結**，不是在同一頁換狀態：圖片、價格、庫存、
 * 加入購物車全都跟著那一頁走，SEO 上每件也仍是獨立頁。
 *
 * a11y：每一排是 role="group"＋aria-labelledby 指向軸名；目前這件的鈕是
 * aria-current="page"；沒有對應組合的值畫成 aria-disabled 的 <span>（不可聚焦、
 * 不可點）。觸控目標 ≥ 44px，排不下自動換行。
 */
import { useId } from "react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { variantOptions, type VariantGroup } from "@/lib/product-variants";

const COPY: Record<"unavailable", Localized> = {
  unavailable: { zh: "此組合無販售", en: "Not available", ja: "取り扱いなし" },
};

const BASE =
  "inline-flex min-h-11 min-w-11 items-center justify-center border px-4 py-2 text-sm leading-snug transition-colors";

export function VariantSwitcher({ group }: { group: VariantGroup }) {
  const t = useT();
  const baseId = useId();

  return (
    <div className="mt-8 space-y-6" data-testid="variant-switcher">
      {group.axes.map((axis, axisIndex) => {
        const labelId = `${baseId}-axis-${axisIndex}`;
        const name = typeof axis.name === "string" ? axis.name : t(axis.name);
        return (
          <div key={labelId} role="group" aria-labelledby={labelId}>
            <p id={labelId} className="eyebrow text-xl">
              {name}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {variantOptions(group, axisIndex).map((opt) => {
                if (opt.disabled || opt.slug === null) {
                  return (
                    <span
                      key={opt.value}
                      aria-disabled="true"
                      title={t(COPY.unavailable)}
                      className={`${BASE} cursor-not-allowed border-border text-muted-foreground line-through opacity-40`}
                    >
                      {opt.value}
                    </span>
                  );
                }
                return (
                  <Link
                    key={opt.value}
                    to="/shop/$slug"
                    params={{ slug: opt.slug }}
                    aria-current={opt.selected ? "page" : undefined}
                    data-variant-value={opt.value}
                    className={`${BASE} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                      opt.selected
                        ? "border-foreground bg-foreground text-primary-foreground"
                        : "border-border hover:border-foreground"
                    }`}
                  >
                    {opt.value}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
