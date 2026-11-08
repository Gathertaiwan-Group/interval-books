import type { ReactNode } from "react";
import { useT } from "@/i18n/LanguageContext";
import { SiteHeader } from "./SiteHeader";
import { SiteFooter } from "./SiteFooter";

/** 「跳到主要內容」：鍵盤使用者按第一下 Tab 就看得到，略過頁首導覽。 */
const SKIP_LABEL = { zh: "跳到主要內容", en: "Skip to main content", ja: "本文へスキップ" };

export function PageShell({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="min-h-screen flex flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-foreground focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        {t(SKIP_LABEL)}
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  intro,
  compact = false,
}: {
  eyebrow: string;
  title: string;
  intro?: string;
  /**
   * 只影響手機（md 以下）：縮小上下留白與標題字級，讓列表頁的內容進得了首屏。
   * md 以上與預設完全相同。目前只有 /shop 用（2026-11 手機版優化）。
   */
  compact?: boolean;
}) {
  return (
    <section
      className={`container-editorial md:pt-24 md:pb-16 ${compact ? "pt-8 pb-6" : "pt-16 pb-12"}`}
    >
      <p className="eyebrow text-2xl">{eyebrow}</p>
      <h1
        className={`display md:mt-6 md:leading-[1.12] md:text-6xl lg:text-7xl max-w-4xl ${
          compact ? "mt-3 text-[2rem] leading-[1.2]" : "mt-6 text-[2.75rem] leading-[1.12]"
        }`}
      >
        {title}
      </h1>
      {intro && (
        <p
          className={`max-w-2xl md:mt-8 md:text-lg md:leading-[1.9] text-muted-foreground ${
            compact ? "mt-3 text-sm leading-[1.8]" : "mt-8 text-base leading-[1.9]"
          }`}
        >
          {intro}
        </p>
      )}
      <div className={`rule md:mt-10 ${compact ? "mt-5" : "mt-10"}`} />
    </section>
  );
}
