import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useT } from "@/i18n/LanguageContext";
import { newsAnchorId, type NewsTickerEntry } from "@/lib/cms";
import { useSiteContent } from "@/lib/site-content";

/**
 * 每則停留的時間。2026-10-26 實測 15 個有公告列的站：輪播間隔 3.3–6 秒、中位數約 5 秒；
 * 書店的消息是整句（講座、休館、策旅），取偏慢的 6 秒，讀得完、換則時也不搶眼。
 */
const DWELL_MS = 6000;

const COPY = {
  pause: { zh: "暫停輪播", en: "Pause", ja: "一時停止" },
  play: { zh: "繼續輪播", en: "Play", ja: "再生" },
  prev: { zh: "上一則", en: "Previous", ja: "前へ" },
  next: { zh: "下一則", en: "Next", ja: "次へ" },
};

/** 標題在後台可以換行（/news 卡片用 pre-line）；這裡只有一行，換行與連續空白收成一格。 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 首頁頁首下方的「最新消息」列（2026-10-26 取代首頁底部那三張長卡片）。
 *
 * 形式是「單行淡入淡出輪播」，不是連續捲動的跑馬燈：實測的精品／編輯型站（Aesop、
 * Shakespeare and Company、Glossier、Pangaia、Papier、Foyles…）有公告列的都是這種，連續
 * 捲動只在潮牌／促銷型站看到；整句消息也不該逼人追著字讀。
 *
 * - SSR 與 hydration 都畫第 0 則（index 是 state、初值 0），不會 #418。
 * - 每 DWELL_MS 換下一則，0.7 秒交叉淡入淡出（styles.css 的 .news-ticker）。
 * - 滑鼠停在上面、鍵盤焦點在裡面、或按了暫停鈕 → 不換。會自己動的內容一定要有暫停鈕
 *   （WCAG 2.2.2），觸控裝置沒有 hover，所以手機也留著那顆鈕。
 * - 沒顯示的那幾則 aria-hidden、連結不進 tab 順序；不設 aria-live，換則不會一直被念出來。
 * - prefers-reduced-motion：不自動換，改成一排可以左右滑的靜態連結（CSS 切版，JS 不啟動計時）。
 * - 只有一則就靜態顯示；沒有任何一則整條不出現。
 * - 每一則連到 /news#news-<id>：消息沒有逐則的內頁，錨點落在 /news 上那一張卡。
 */
export function NewsTicker({ items }: { items: NewsTickerEntry[] }) {
  const t = useT();
  const { ui } = useSiteContent();
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  const count = items.length;
  const rotating = count > 1;
  const paused = userPaused || hovered || focused;

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!rotating || paused || reducedMotion) return;
    const id = window.setTimeout(() => setIndex((i) => (i + 1) % count), DWELL_MS);
    return () => window.clearTimeout(id);
  }, [rotating, paused, reducedMotion, count, index]);

  if (!count) return null;
  const active = index % count;
  const label = t(ui.sections.latestNews);
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);

  return (
    <section
      aria-label={label}
      className="news-ticker"
      data-rotating={rotating ? "" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="container-editorial news-ticker-row">
        <Link to="/news" className="news-ticker-label">
          {label}
        </Link>

        <ul className="news-ticker-viewport">
          {items.map((n, i) => {
            const on = i === active;
            // 減少動態時每一則都攤開來看得到，就都要念得到、按得到
            const exposed = on || reducedMotion;
            return (
              <li
                key={n.id}
                className="news-ticker-item"
                data-active={on ? "" : undefined}
                aria-hidden={exposed ? undefined : true}
              >
                <Link
                  to="/news"
                  hash={newsAnchorId(n.id)}
                  tabIndex={exposed ? undefined : -1}
                  className="news-ticker-link"
                >
                  {n.date && <span className="news-ticker-date">{oneLine(n.date)}</span>}
                  <span className="news-ticker-title">{oneLine(t(n.title))}</span>
                </Link>
              </li>
            );
          })}
        </ul>

        {rotating && (
          <div className="news-ticker-controls">
            <span className="news-ticker-count" aria-hidden="true">
              {active + 1}／{count}
            </span>
            <button
              type="button"
              className="news-ticker-btn news-ticker-step"
              aria-label={t(COPY.prev)}
              onClick={() => go(-1)}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <button
              type="button"
              className="news-ticker-btn"
              aria-label={t(userPaused ? COPY.play : COPY.pause)}
              onClick={() => setUserPaused((v) => !v)}
            >
              {userPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="news-ticker-btn news-ticker-step"
              aria-label={t(COPY.next)}
              onClick={() => go(1)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
        )}

        <Link to="/news" className="news-ticker-all hover-underline">
          {t(ui.buttons.viewAll)} →
        </Link>
      </div>
    </section>
  );
}
