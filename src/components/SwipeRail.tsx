/**
 * 手機與桌機都橫向滑動的一列卡片（/partnership「我們做過的合作類型」用）。
 *
 * 寬度與 scroll-snap 來自 src/lib/card-rail.ts 的 swipeRail()（手機 82%、md 約 2.2 張、lg 約 2.7 張，
 * 永遠露出下一張一截）。這裡只多做兩件 class 做不到的事：
 *   - 「左右滑動看更多 →」提示與左右箭頭，**只有內容真的超出寬度時**才出現（量 scrollWidth）。
 *     SSR 時一律不畫，hydration 後才量；不會先畫出來又消失。
 *   - 箭頭一次捲大約一張卡；prefers-reduced-motion 時不做平滑捲動。
 * 鍵盤：列本身可 Tab 聚焦（tabIndex=0、role=region），聚焦後左右方向鍵由瀏覽器原生捲動。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/i18n/LanguageContext";
import { swipeRail, SWIPE_HINT, SWIPE_PREV, SWIPE_NEXT } from "@/lib/card-rail";
import type { Localized } from "@/i18n/types";

type Props = {
  count: number;
  label: Localized;
  children: ReactNode;
  className?: string;
};

export function SwipeRail({ count, label, children, className = "" }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ scrollable: false, atStart: true, atEnd: false });
  const rail = swipeRail(count);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setState({
      scrollable: max > 4,
      atStart: el.scrollLeft <= 4,
      atEnd: el.scrollLeft >= max - 4,
    });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [measure]);

  const step = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const card = el.firstElementChild as HTMLElement | null;
    const amount = card ? card.getBoundingClientRect().width + 24 : el.clientWidth * 0.8;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * amount, behavior: reduce ? "auto" : "smooth" });
  };

  const arrow =
    "inline-flex h-10 w-10 items-center justify-center border border-border bg-card/70 text-foreground transition-colors hover:border-foreground/40 disabled:cursor-default disabled:opacity-30";

  return (
    <div className={className}>
      <div
        ref={ref}
        data-reveal-stagger
        role="region"
        aria-label={t(label)}
        tabIndex={state.scrollable ? 0 : -1}
        className={`${rail.track} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground/40`}
      >
        {children}
      </div>
      {state.scrollable && (
        <div className="mt-4 flex items-center justify-between gap-4">
          <p className="text-xs tracking-[0.12em] text-muted-foreground" aria-hidden="true">
            {t(SWIPE_HINT)}
            <span className="ml-1">→</span>
          </p>
          <div className="hidden gap-2 md:flex">
            <button
              type="button"
              className={arrow}
              onClick={() => step(-1)}
              disabled={state.atStart}
              aria-label={t(SWIPE_PREV)}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={arrow}
              onClick={() => step(1)}
              disabled={state.atEnd}
              aria-label={t(SWIPE_NEXT)}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
