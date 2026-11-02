import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useLang, writeStoredLang } from "@/i18n/LanguageContext";
import { switchLangHref } from "@/lib/seo/i18n";
import { writeLangChoice } from "@/lib/lang-autodetect";

const DISMISS_KEY = "interval-books-lang-hint-dismissed";

const COPY = {
  en: { text: "This page is also available in English.", action: "View in English" },
  ja: { text: "このページは日本語でもご覧いただけます。", action: "日本語で表示" },
} as const;

/**
 * 中文頁上的「View in English?」小提示（2026-11 /en /ja）。
 *
 * 有了依瀏覽器語系的自動導向（src/lib/lang-autodetect.ts）之後仍保留，但只負責**自動導向
 * 不會發生**的情況：
 *   · 自動導向每位訪客只做一次。英文訪客第一次來被導去 /en 之後，日後打開朋友分享的中文連結
 *     就不再轉——這時給一個不擋畫面的提示，按了才去 /en。
 *   · 訪客手動選過英文／日文（之後永遠不自動導），又打開中文連結。
 * 會自動導的情況，<head> 的 script 在畫面出來前就轉走了，這個提示根本來不及出現；手動選回中文的
 * 訪客，記住的語言是中文，也不會出現。
 *
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
        onClick={() => {
          writeStoredLang(stored);
          writeLangChoice(stored);
        }}
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
