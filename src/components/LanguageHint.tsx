import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useLang, writeStoredLang } from "@/i18n/LanguageContext";
import { switchLangHref } from "@/lib/seo/i18n";

const DISMISS_KEY = "interval-books-lang-hint-dismissed";

const COPY = {
  en: { text: "This page is also available in English.", action: "View in English" },
  ja: { text: "このページは日本語でもご覧いただけます。", action: "日本語で表示" },
} as const;

/**
 * 中文頁上的「View in English?」小提示（2026-11 /en /ja）。
 *
 * 訪客記住的語言是英文或日文、但打開的是中文網址（例如別人分享的連結）時，**不自動轉走**——
 * Googlebot 與分享連結都不能被轉——只在角落放一個不擋畫面的提示，按了才去 /en、/ja。
 * 掛載之後才可能出現（SSR 沒有記住的語言），所以不會造成 hydration 不一致。
 * 關掉之後這個分頁（sessionStorage）不再出現。
 */
export function LanguageHint() {
  const { urlLang, stored } = useLang();
  const publicHref = useRouterState({ select: (s) => s.location.publicHref });
  // head 是換頁「完成」時才換成新頁面的（resolvedLocation），等它換好再看 hreflang。
  const resolvedHref = useRouterState({ select: (s) => s.resolvedLocation?.publicHref });
  const [dismissed, setDismissed] = useState(true);
  // 這一頁有沒有那個語言的版本：看 head 裡有沒有它的 hreflang（pageHead() 只為可收錄的語言輸出，
  // 跟 noindex 規則同一個判斷）。沒翻譯的頁（中文限定著陸頁、資料缺翻譯）就不提示。
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  useEffect(() => {
    if (stored !== "en" && stored !== "ja") {
      setAvailable(false);
      return;
    }
    setAvailable(
      document.head.querySelector(`link[rel="alternate"][hreflang="${stored}"]`) !== null,
    );
  }, [stored, resolvedHref]);

  if (dismissed || !available || urlLang !== "zh" || (stored !== "en" && stored !== "ja"))
    return null;
  const href = publicHref ?? "/";
  const target = switchLangHref(href, stored);
  const copy = COPY[stored];

  const dismiss = () => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      lang={stored}
      role="region"
      aria-label={copy.action}
      className="fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 border border-border bg-background/95 px-4 py-3 text-xs shadow-sm backdrop-blur"
    >
      <span className="text-muted-foreground">{copy.text}</span>
      <a
        href={target}
        hrefLang={stored}
        onClick={() => writeStoredLang(stored)}
        className="whitespace-nowrap border-b border-foreground pb-0.5 text-foreground"
      >
        {copy.action}
      </a>
      <button
        type="button"
        onClick={dismiss}
        aria-label={stored === "ja" ? "閉じる" : "Close"}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
