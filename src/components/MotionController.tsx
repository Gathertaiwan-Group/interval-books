import { useEffect } from "react";
import { startScrollReveal } from "@/lib/motion";

/**
 * 捲動浮現的開關（規則與標記方式見 src/lib/motion.ts）。掛在 root，不畫任何東西。
 *
 * 等整頁 hydrate 完才啟動：root 的 effect 跑的時候，各頁的元件（分檔載入、在 Suspense 裡）
 * 可能還沒 hydrate，這時去改它們的屬性，React 會報 hydration 屬性不一致。所以等 window load
 * 之後、瀏覽器空下來再開——那之前 SSR 的內容本來就是完整顯示的，晚一點開只是首屏外的元素
 * 晚一點被收起來（使用者看不到）。
 */
export function MotionController() {
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    let idleId: number | null = null;
    let timer: number | null = null;

    const start = () => {
      if (cancelled) return;
      stop = startScrollReveal();
    };
    const schedule = () => {
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(start, { timeout: 1500 });
      } else {
        timer = window.setTimeout(start, 200);
      }
    };

    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });

    return () => {
      cancelled = true;
      window.removeEventListener("load", schedule);
      if (idleId !== null) window.cancelIdleCallback?.(idleId);
      if (timer !== null) window.clearTimeout(timer);
      stop?.();
    };
  }, []);
  return null;
}
