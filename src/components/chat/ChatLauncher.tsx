/**
 * 右下角的 AI 小幫手泡泡（只有按鈕；對話面板 ChatPanel 是另一個 chunk，第一次點開才下載）。
 *
 * ── 不影響 LCP ────────────────────────────────────────────────────────────
 * SSR 不輸出任何東西；等 window load 之後再等一個 idle 才畫泡泡。面板的程式碼用 lazy()，
 * 只有真的點開（或滑過／聚焦泡泡時預先抓）才載入。
 *
 * ── 不擋東西 ──────────────────────────────────────────────────────────────
 * 手機底部有些頁面有固定的報名列（例：/events/sound-of-the-sea），右下角也可能有語言提示
 * （LanguageHint）。泡泡每次換頁／捲動／縮放時量一次：右下角那塊區域被哪個 fixed／sticky
 * 元素蓋到，就往上移到它上面。底部再加 iOS Safari 的 safe-area。
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { MessageCircle, X } from "lucide-react";
import { useLang } from "@/i18n/LanguageContext";
import { chatHiddenFor } from "@/lib/chat-assistant";

const loadPanel = () => import("./ChatPanel");
const ChatPanel = lazy(loadPanel);

const LABEL = {
  zh: { open: "開啟 AI 小幫手", close: "關閉 AI 小幫手" },
  en: { open: "Open AI assistant", close: "Close AI assistant" },
  ja: { open: "AI アシスタントを開く", close: "AI アシスタントを閉じる" },
} as const;

const BASE_GAP = 16; // px，泡泡與底邊／障礙物的距離
const SIZE = 56;

/** 右下角泡泡會佔的區域被哪些 fixed／sticky 元素擋到 → 回傳需要往上墊多少 px。 */
function measureObstruction(self: Element | null): number {
  if (typeof window === "undefined") return 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const zone = {
    left: vw - SIZE - BASE_GAP * 2,
    top: vh - SIZE - BASE_GAP * 2,
    right: vw,
    bottom: vh,
  };
  let lift = 0;
  const nodes = document.querySelectorAll<HTMLElement>(
    '[class*="fixed"],[class*="sticky"],[style*="fixed"]',
  );
  nodes.forEach((el) => {
    if (self && (el === self || self.contains(el) || el.contains(self))) return;
    if (el.closest("[data-chat-root]")) return;
    const cs = getComputedStyle(el);
    if (
      (cs.position !== "fixed" && cs.position !== "sticky") ||
      cs.visibility === "hidden" ||
      cs.display === "none"
    )
      return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // 全螢幕的遮罩（例如抽屜的背景）不算：那時泡泡本來就該被蓋住。
    if (r.height > vh * 0.6) return;
    const overlaps =
      r.left < zone.right && r.right > zone.left && r.top < zone.bottom && r.bottom > zone.top;
    if (!overlaps) return;
    lift = Math.max(lift, vh - r.top);
  });
  return Math.min(lift, vh * 0.5);
}

export function ChatLauncher() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { lang } = useLang();
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false); // 面板載入過一次就留著（保留對話）
  const [lift, setLift] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const hidden = chatHiddenFor(pathname);

  // load + idle 之後才出現
  useEffect(() => {
    let cancelled = false;
    let idleId: number | undefined;
    const go = () => {
      const ric = (
        window as unknown as {
          requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
        }
      ).requestIdleCallback;
      if (ric) idleId = ric(() => !cancelled && setReady(true), { timeout: 3000 });
      else idleId = window.setTimeout(() => !cancelled && setReady(true), 1200);
    };
    if (document.readyState === "complete") go();
    else window.addEventListener("load", go, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", go);
      const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void })
        .cancelIdleCallback;
      if (idleId !== undefined) (cic ?? window.clearTimeout)(idleId);
    };
  }, []);

  // 量障礙物：換頁、縮放、捲動（節流）、以及頁面晚一點才冒出來的東西（1.5 秒後再量一次）
  const remeasure = useCallback(() => setLift(measureObstruction(btnRef.current)), []);
  useEffect(() => {
    if (!ready || hidden) return;
    remeasure();
    const t1 = window.setTimeout(remeasure, 1500);
    let pending = 0;
    const onScroll = () => {
      if (pending) return;
      pending = window.setTimeout(() => {
        pending = 0;
        remeasure();
      }, 250);
    };
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(t1);
      if (pending) window.clearTimeout(pending);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, [ready, hidden, pathname, remeasure]);

  // 換到不顯示的頁面時收起來
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  const close = useCallback(() => {
    setOpen(false);
    // 焦點回到泡泡
    window.setTimeout(() => btnRef.current?.focus(), 0);
  }, []);

  if (!ready || hidden) return null;
  const l = LABEL[lang] ?? LABEL.zh;

  return (
    <div data-chat-root="">
      {mounted && (
        <Suspense fallback={null}>
          <ChatPanel open={open} onClose={close} lang={lang} bottomOffset={lift} />
        </Suspense>
      )}
      <button
        ref={btnRef}
        type="button"
        aria-label={open ? l.close : l.open}
        aria-expanded={open}
        aria-controls="ib-chat-panel"
        aria-haspopup="dialog"
        onPointerEnter={() => void loadPanel()}
        onFocus={() => void loadPanel()}
        onClick={() => {
          setMounted(true);
          setOpen((o) => !o);
        }}
        style={{
          bottom: `calc(${BASE_GAP + lift}px + env(safe-area-inset-bottom, 0px))`,
          width: SIZE,
          height: SIZE,
        }}
        className={`fixed right-4 z-40 flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-1 ring-black/5 transition-[transform,bottom] duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:right-6 ${open ? "max-sm:hidden" : ""}`}
      >
        {open ? (
          <X className="h-6 w-6" aria-hidden />
        ) : (
          <MessageCircle className="h-6 w-6" aria-hidden />
        )}
      </button>
    </div>
  );
}
