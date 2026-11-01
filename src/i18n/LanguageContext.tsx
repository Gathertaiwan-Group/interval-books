import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Lang, Localized } from "./types";

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (l: Localized) => string;
};

const LanguageContext = createContext<Ctx | null>(null);
const STORAGE_KEY = "interval-books-lang";

/**
 * 初次造訪一律中文；只有訪客**自己按過**語言切換（存進 localStorage）才換。
 *
 * 🔴 不要再依 navigator.language 自動換語言（2026-11 SEO 健檢 H2）。原本 en-US 的瀏覽器
 *    一載入就把整頁（<html lang>、title、h1、description）換成英文——而 Googlebot 的
 *    渲染器就是 en-US 的 Chromium，結果中文頁被當成英文頁收錄。SSR 輸出的永遠是中文，
 *    初次渲染必須跟它一致。英日文要被收錄，正解是 /en、/ja 網址前綴（需要業主決定），
 *    不是在同一個網址上偷換內容。
 */
function detectInitial(): Lang {
  if (typeof window === "undefined") return "zh";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved === "zh" || saved === "en" || saved === "ja") return saved;
  } catch {
    /* ignore */
  }
  return "zh";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("zh");

  useEffect(() => {
    const initial = detectInitial();
    setLangState(initial);
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = lang === "zh" ? "zh-Hant" : lang === "ja" ? "ja" : "en";
    }
  }, [lang]);

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  };

  const t = (entry: Localized) => entry[lang] || entry.zh;

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>{children}</LanguageContext.Provider>
  );
}

export function useLang() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLang must be used within LanguageProvider");
  return ctx;
}

export function useT() {
  return useLang().t;
}

/**
 * 讓一段子樹固定用某一種語言顯示，不管訪客選了什麼。給「只有中文版」的獨立著陸頁用
 * （例：events.kungtung.tsx 的報名區），共用的 SessionPicker／PlanPicker 才不會在
 * 中文頁面裡冒出英文。setLang 原封轉給外層，不改訪客記住的語言偏好。
 */
export function FixedLanguage({ lang, children }: { lang: Lang; children: ReactNode }) {
  const parent = useLang();
  const t = (entry: Localized) => entry[lang] || entry.zh;
  return (
    <LanguageContext.Provider value={{ lang, setLang: parent.setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}
