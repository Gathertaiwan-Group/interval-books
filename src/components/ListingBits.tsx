/**
 * 活動／策旅卡片上的日期、報名狀態小標與「票價＋查看 →」一列。
 *
 * 原本是首頁（src/routes/index.tsx）的區域元件；2026-11-10 /events 與 /journeys 合併後，
 * /events 的策旅卡片也要印同樣的日期區間與票價，所以搬到這裡兩邊共用（同一份樣式、同一份文案）。
 * 資料來源是 src/lib/home-listing.ts 的 fetchListingFacts()（只供顯示，不拿來算名額上限）。
 */
import type { ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { useT } from "@/i18n/LanguageContext";
import type { ListingFacts } from "@/lib/home-listing";
import { formatPrice } from "@/lib/shop";

const LISTING_COPY = {
  free: { zh: "免費", en: "Free", ja: "無料" },
  soldOut: { zh: "已額滿", en: "Sold out", ja: "満席" },
  fewLeft: { zh: "最後 {n} 位", en: "{n} left", ja: "残り{n}席" },
};

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

/** 卡片上的日期：用正文色＋圖示，不再是一行淺灰小字。內容是 display_date（自由文字）。 */
export function ListingDate({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 flex items-start gap-2 text-sm font-medium text-foreground/90 [font-variant-numeric:lining-nums]">
      <CalendarDays className="mt-[0.15em] h-4 w-4 shrink-0 text-clay" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** 報名狀態小標（「已額滿」／「最後 N 位」），放在卡片頂端分類那一行的右邊。平常不印。 */
export function ListingBadge({ facts }: { facts: ListingFacts | undefined }) {
  const t = useT();
  if (!facts) return null;
  if (facts.soldOut) {
    return (
      <span className="-my-1 shrink-0 border border-border px-2 py-0.5 text-xs tracking-[0.1em] text-muted-foreground">
        {t(LISTING_COPY.soldOut)}
      </span>
    );
  }
  if (facts.fewLeft === null) return null;
  return (
    <span className="-my-1 shrink-0 border border-clay/40 px-2 py-0.5 text-xs tracking-[0.1em] text-clay">
      {fill(t(LISTING_COPY.fewLeft), { n: facts.fewLeft })}
    </span>
  );
}

/**
 * 卡片底部一列：左邊票價，右邊「查看 →」。整張卡本來就是連結，這一列只是讓人一眼看到
 * 價格與下一步。facts 讀不到時只剩右邊的箭頭；cta 為 null（策旅沒設連結）時只剩左邊。
 * 兩邊都沒有就整列不畫。
 */
export function ListingFooter({
  facts,
  cta,
}: {
  facts: ListingFacts | undefined;
  cta: string | null;
}) {
  const t = useT();
  if (!facts && !cta) return null;
  return (
    <div className="mt-5 flex min-h-11 items-center justify-between gap-3 border-t border-border/70 pt-3 md:mt-6 md:pt-4">
      {facts ? (
        <span className="text-base font-medium text-foreground [font-variant-numeric:lining-nums]">
          {facts.price > 0 ? formatPrice(facts.price) : t(LISTING_COPY.free)}
        </span>
      ) : (
        <span />
      )}
      {cta ? (
        <span className="link-arrow shrink-0 text-sm">
          {cta}
          <span className="arrow" aria-hidden="true">
            →
          </span>
        </span>
      ) : null}
    </div>
  );
}
