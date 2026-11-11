/**
 * 前台動效（2026-11）：捲動浮現（scroll reveal）＋站內換頁過場（view transition）。
 *
 * 品牌調性是安靜、紙質感，所以兩者都刻意克制：浮現只有淡入＋14px 上移，換頁只有交叉淡化＋
 * 5px 上移。樣式在 src/styles.css「前台動效」一段，這支只負責「什麼時候播、播哪些」。
 *
 * ── 🔴 不能傷 SEO 與無障礙 ─────────────────────────────────────────────
 * SSR 出來的 HTML 一律是**看得見的**：沒有 inline opacity、沒有隱藏用的 class。只有在瀏覽器
 * 跑到 startScrollReveal()、而且使用者沒開「減少動態效果」時，才在 <html> 加上
 * data-motion="on"；CSS 只在那個屬性底下，把「還沒進過視窗」的元素藏起來。
 * 加屬性之前，先把**已經在視窗裡（或在視窗上方）**的元素標成已顯示——首屏不播動畫，
 * 不會閃一下、也不拖慢 LCP。
 *
 * ── 怎麼標 ─────────────────────────────────────────────────────────────
 *   data-reveal          這個元素整塊淡入（標題、段落、整列橫滑卡片）
 *   data-reveal-stagger  直接子元素各自淡入，同一批進視窗的依序錯開 70ms（最多錯開前 6 張）。
 *                        容器本身若是橫向捲動（手機的 card-rail），其中一張進視窗就整列一起
 *                        出現——不會滑過去才看到空白。
 * 元素只在第一次進入視窗時播一次。
 */

export const REVEAL_STAGGER_MS = 70;
/** 錯開前幾張：第 6 張之後的延遲都跟第 6 張一樣。 */
export const REVEAL_STAGGER_MAX = 6;

/** 同一批進視窗的第 index 個元素要延遲幾毫秒。 */
export function revealDelay(index: number): number {
  const i = Math.min(Math.max(Math.floor(index), 0), REVEAL_STAGGER_MAX - 1);
  return i * REVEAL_STAGGER_MS;
}

/** 去掉 /en、/ja 語言前綴（路由表的 pathname 本來就沒有，保險起見兩種都吃）。 */
function stripLangPrefix(pathname: string): string {
  return pathname.replace(/^\/(en|ja)(?=\/|$)/, "") || "/";
}

/**
 * 不套換頁過場的頁面：後台、廠商後台、結帳。這些頁面重在操作，畫面凍結 0.3 秒只會礙事；
 * 結帳更不該讓人覺得「頁面在動」。進出這些頁面（任一端）都不播。
 */
export function isMotionExcludedPath(pathname: string): boolean {
  const p = stripLangPrefix(pathname);
  return /^\/(admin|vendor|checkout)(\/|$)/.test(p);
}

/**
 * 這次換頁要不要播過場。
 * - 第一次載入（沒有上一頁）不播
 * - 只改了 ?query 或 #hash（/events 切月份、篩選）不播——同一頁的狀態變化不該整頁淡出淡入
 * - 減少動態效果、或任一端是後台／結帳不播
 */
export function shouldPageTransition(opts: {
  fromPath: string | undefined;
  toPath: string;
  reducedMotion: boolean;
}): boolean {
  const { fromPath, toPath, reducedMotion } = opts;
  if (reducedMotion || !fromPath) return false;
  if (fromPath === toPath) return false;
  return !isMotionExcludedPath(fromPath) && !isMotionExcludedPath(toPath);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const TARGETS = "[data-reveal], [data-reveal-stagger] > *";
const PENDING = "[data-reveal]:not([data-revealed]), [data-reveal-stagger] > :not([data-revealed])";

/**
 * 啟動捲動浮現。回傳清除函式。瀏覽器端、hydrate 之後呼叫一次（見 src/components/MotionController.tsx）。
 * 減少動態效果／沒有 IntersectionObserver → 什麼都不做（內容本來就是看得見的）。
 */
export function startScrollReveal(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") return () => {};

  const root = document.documentElement;
  const pending = new Set<Element>();

  const show = (el: Element, delay: number | null) => {
    pending.delete(el);
    io.unobserve(el);
    if (delay === null) {
      el.setAttribute("data-revealed", "now");
      return;
    }
    if (el instanceof HTMLElement || el instanceof SVGElement) {
      el.style.setProperty("--reveal-delay", `${delay}ms`);
    }
    el.setAttribute("data-revealed", "fade");
  };

  const isHorizontalRail = (el: Element | null): el is HTMLElement =>
    el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1;

  const io = new IntersectionObserver(
    (entries) => {
      // 同一批進視窗的：每個 stagger 容器各自從 0 開始錯開；單獨的 data-reveal 另一組計數。
      const counters = new Map<Element | null, number>();
      const batch: Element[] = [];
      for (const entry of entries) {
        if (!entry.isIntersecting || !pending.has(entry.target)) continue;
        const el = entry.target;
        const parent = el.parentElement;
        if (parent?.hasAttribute("data-reveal-stagger") && isHorizontalRail(parent)) {
          // 橫滑列：一張進來，整列（還沒出現的）一起出現
          for (const sib of Array.from(parent.children)) {
            if (pending.has(sib) && !batch.includes(sib)) batch.push(sib);
          }
        } else if (!batch.includes(el)) {
          batch.push(el);
        }
      }
      for (const el of batch) {
        const parent = el.parentElement;
        const key = parent?.hasAttribute("data-reveal-stagger") ? parent : null;
        const n = counters.get(key) ?? 0;
        counters.set(key, n + 1);
        show(el, revealDelay(n));
      }
    },
    // 進到視窗底部往上 6% 才開始，免得剛露出一條邊就播完
    { rootMargin: "0px 0px -6% 0px", threshold: 0 },
  );

  /** 登記一個元素：已經在視窗裡或在視窗上方 → 直接顯示（不播）；在下方 → 等它進來。 */
  const register = (el: Element) => {
    if (el.hasAttribute("data-revealed") || pending.has(el)) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight) {
      show(el, null);
      return;
    }
    pending.add(el);
    io.observe(el);
  };

  // 1) 先處理現有元素（首屏的直接標成已顯示），2) 再打開 CSS 開關。同一個 task 內完成，
  //    瀏覽器不會畫出「首屏內容被藏起來」的那一格。
  document.querySelectorAll(TARGETS).forEach(register);
  root.setAttribute("data-motion", "on");

  // 換頁、資料載入後新長出來的元素。MutationObserver 的 callback 是 microtask，
  // 在下一次繪製之前就跑完——在視窗裡的新元素不會先被藏起來一格。
  const mo = new MutationObserver((records) => {
    if (isMotionExcludedPath(window.location.pathname)) return;
    let added = false;
    let removed = false;
    for (const r of records) {
      if (r.addedNodes.length) added = true;
      if (r.removedNodes.length) removed = true;
    }
    if (removed) {
      for (const el of pending) {
        if (!el.isConnected) {
          pending.delete(el);
          io.unobserve(el);
        }
      }
    }
    if (added) document.querySelectorAll(PENDING).forEach(register);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // 使用者中途打開「減少動態效果」：拿掉開關，所有內容立刻顯示。
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onChange = () => {
    if (mq.matches) stop();
  };
  mq.addEventListener?.("change", onChange);

  function stop() {
    mo.disconnect();
    io.disconnect();
    pending.clear();
    root.removeAttribute("data-motion");
    mq.removeEventListener?.("change", onChange);
  }
  return stop;
}
