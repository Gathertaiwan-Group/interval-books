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
}: {
  eyebrow: string;
  title: string;
  intro?: string;
}) {
  return (
    <section className="container-editorial pt-16 md:pt-24 pb-12 md:pb-16">
      <p className="eyebrow text-2xl">{eyebrow}</p>
      <h1 className="display mt-6 text-[2.75rem] leading-[1.12] md:text-6xl lg:text-7xl max-w-4xl">
        {title}
      </h1>
      {intro && (
        <p className="mt-8 max-w-2xl text-base md:text-lg leading-[1.9] text-muted-foreground">
          {intro}
        </p>
      )}
      <div className="rule mt-10" />
    </section>
  );
}
